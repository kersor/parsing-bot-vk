import { Keyboard, VK } from 'vk-io'
import { HearManager } from '@vk-io/hear';
import axios from 'axios'
import * as fs from 'fs'
import fsPromise from 'fs/promises';
import path from 'path'
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import FormData from 'form-data';
import colors from 'colors'


const token_group = new VK ({
    token: process.env.TOKEN_GROUP
})
const token_service = new VK({
    token: process.env.TOKEN_SERVICE
}) 
const token_user = new VK({
    token: process.env.TOKEN_USER
})
const {updates} = token_group
const prisma = new PrismaClient()  













// * * * * * * * * * * * * * * 
// * ФУНКЦИИ ДЛЯ НОВОЙ ГРУППЫ *
// * * * * * * * * * * * * * * 
const hearManager = new HearManager();

// объект состояния пользователя
const userStates = {};

// middleware для ловли ссылки
const groupMiddleware = async (context, next) => {
    const userId = context.senderId

    if(userStates[userId] && userStates[userId].waitingForGroupLink){
        await funcWorkInParsingGroup(context)
        userStates[userId].waitingForGroupLink = false
    }
    await next()
}

updates.use(groupMiddleware)
updates.use(hearManager.middleware);



// Добавление базовых кнопок
hearManager.hear(/^Начать$/, async (context) => {
    if(context.senderId === +process.env.SENDER_ID){
        await context.send({ 
            message: `Выберите дальнейшие действия:`,
            keyboard: Keyboard.builder()
                .textButton({
                    label: 'Добавить группу',
                    payload: {
                        command: 'add_group'
                    }
                }).row()
                .textButton({
                    label: 'Вывести список групп',
                    payload: {
                        command: 'get_list_group'
                    }
                }).row()  
        });
    }
}) 

// Если пользователь нажмет на кнопку Добавить группу, то сработает этот обработчик
hearManager.hear(/^Добавить группу$/, async (context) => {
    if (context.senderId === +process.env.SENDER_ID) {
        userStates[context.senderId] = { waitingForGroupLink: true };
        await context.send('Отправьте мне ссылку группы');
    }
}) 


hearManager.hear(/^Вывести список групп$/, async (context) => {
    if (context.senderId === +process.env.SENDER_ID) {
        const groups = await funcGetAllGroups()
        if(groups.length !== 0){
            groups.map(async (item, index) => {
                await context.send({
                    message: `Группа #${++index}: ${item.domain}\nФотографий хранится: ${item.photo.length}`,
                    keyboard: Keyboard.builder()
                        .urlButton({
                            label: item.domain,
                            url: `https://vk.com/${item.domain}`
                        }).inline()
                })
            })
        }
        else{
            context.send('В БД нет групп')
            return
        }
    }
}) 


async function funcWorkInParsingGroup(context) {
    // Создание папки Photos
    await funcCheckingFolderPhotos()  

    // Берем Домен
    const domain = funcTakeDomain(context)
    if(!domain) return

    // Проверка на уникальнсоть группы в БД
    const checkGroup = await funcFoundGroup(domain)
    if(checkGroup !== null) {
        context.send(`${domain} уже парсится, выберите другую`)
        return
    }
    
    
    // Информация о группе
    const groupInfo = await funcGroupGetById(domain)
    if(groupInfo.id === +process.env.GROUP_ID) {
        context.send('Вставлять свою же группу нельзя')
        return
    } 

    // Спарсили PHOTO
    const photos = await funcConstructorPhotos(domain, groupInfo.id)


    if(photos !== null || undefined) {
        switch (photos.photos.length) {
            case 1: context.send(`Было найдено ${photos.photos.length} фотография`) 
                break;
            case 2: case 3: case 4: context.send(`Было найдено ${photos.photos.length} фотографии`) 
                break;
            default: context.send(`Было найдено ${photos.photos.length} фотографий`) 
                break;
        }
    }


    // Скачать ФОТО
    const namePhoto = await funcDownloadPhotos(photos)  

    // Отпрвка данных в нашу БД
    await funcRegistredGroupInBase(photos, namePhoto)

    // Отправка фотографий на Сервер VK
    const attachmentsPhotosRaeady = await funcSendPhotosInBaseVk(photos, namePhoto)
    if(attachmentsPhotosRaeady) context.send(`Фотографии были скачены и записаны в нашу Базу Данных`)

    await funcSendPhotosInGroup(attachmentsPhotosRaeady, context)
}

// Создание папки Photos
async function funcCheckingFolderPhotos() {
    if(!fs.existsSync(path.resolve('photos'))) {
        fs.mkdirSync(path.resolve('photos'), { recursive: true }, err => {
            if(err) console.log('Error с созданием папки: photos' , err)
            else console.log('Папка photos создана');
        })
    }
}
// Берем Домен
function funcTakeDomain (context) {
    let url = ''
    if(context.text === undefined || null || false) url = context.attachments[0].url
    else url = context.text

    const domain = url.split('vk.com/')[1]
    if(!domain) {
        context.send('Отправьте корректную ссылку')
        return false
    }

    return domain
} 
// Проверка на уникальнсоть группы в БД
async function funcFoundGroup (domain) {
    const result = await prisma.group.findFirst({where: {domain: domain}})
    return result
}
// Информация о группе 
async function funcGroupGetById(domain) {
    const result = await token_user.api.groups.getById({
        group_id: domain
    })

    return result.groups[0]
}
// Итерация постов в группе, которую парсим на типизацию, чтобы были только PHOTO (могут попасться VIDEO)
async function funcConstructorPhotos (domain, group_id) {
    let offset = 0;
    let result;
    
    do {
        result = await funcWallGet(domain, group_id, offset) 
        if(!result) offset = offset + 1 
    } while (!result);

    return result
}
// Спарсили PHOTO 
async function funcWallGet (domain, group_id, offset) {
    let isRes = true
    
    // Запрос на ФОТО у ОДНОГО поста у группы
    const post = await token_user.api.wall.get({
        owner_id: group_id,
        domain: domain,
        offset: offset,
        count: 1,
        filter: 'all'
    })


    // Подготовили массив для заполнения
    let post_object = {
        domain: domain,
        group_id: group_id,
        post_id: post.items[0].id,
        photos: []
    }

    if(post.items[0].is_pinned === undefined && post.items[0].attachments.length > 0){
        // Фильтрация поста на ФОТО
        post.items[0].attachments.map(item => {
            if(item.type === 'photo')  {
                post_object.photos.push({id: item.photo.id, url: item.photo.orig_photo.url})
                isRes = true
            }
            else  isRes = false
        })
    }
    else return false


    if(isRes || post_object.photos.length > 0) return post_object
    else false
} 
// Скачать ФОТО
async function funcDownloadPhotos (photo) {
    const pathDomain = path.resolve('photos', photo.domain)
    // Создаем подпапку группы
    if(!fs.existsSync(pathDomain)) {
        fs.mkdirSync(pathDomain, { recursive: true }, err => {
            if(err) console.log('Error с созданием папки: ' + photo.domain , err) 
            else console.log(`Папка ${photo.domain} создана`)
        })
    }
    
    // Происходит скачивание PHOTO с сервера
    let namePhoto = []
    const download = photo.photos.map(async item => {
        try {
            const response = await axios({
                method: "GET",
                url: item.url,
                responseType: 'stream'
            })

            const name = `photo-${item.id}-${photo.post_id}.jpg`;
            namePhoto.push(name)
            const pathFull = path.resolve('photos', photo.domain, name)
            const writerStream = fs.createWriteStream(pathFull)
            
            response.data.pipe(writerStream)
            
            return new Promise((resolve, reject) => {
                writerStream.on('finish', resolve);
                writerStream.on('error', reject);
            });
        } catch (error) {
            console.log('Ошибка при скачивании фотографий: ', error)
        }
    })

    await Promise.all(download)
    console.log(colors.bgGray.brightGreen(`Все фотографии с группы ${colors.bgGray.brightYellow(photo.domain)} были скачены`));  
    return namePhoto  
}
// Отправка данных в нашу БД
async function funcRegistredGroupInBase(photo, namePhoto) {
    await prisma.group.create({
        data: {
            group_id: photo.group_id,
            domain: photo.domain,
            post_id: photo.post_id,
            photo: {
                create: photo.photos.map((item, index) => ({
                    photo_id: item.id,
                    name: namePhoto[index]
                }))
            }
        }
    })
    console.log(colors.bgGray.brightGreen('Все фотографии зарестрированы в нашу БД'));
}
// Отправка данных в БД VK
async function funcSendPhotosInBaseVk(photo, namePhoto) {
    // Отправка 
    try {
        // Получили адрес куда отправлять PHOTO
        const uploadServer = await funcUploadServer()

        let attachmentsPhotos = []
        for (const item of namePhoto) {
            const formData = new FormData()
            // Настраиваем поток для отправки
            formData.append(`photo`, fs.createReadStream(path.resolve('photos', photo.domain, item)));


            // Загрузка на сервер
            const uploadResponse = await axios.post(uploadServer.upload_url, formData, {
                headers: {
                    ...formData.getHeaders(),
                },
            });

            // Сохранение результата 
            const saveResponse = await token_user.api.photos.saveWallPhoto({
                server: uploadResponse.data.server,
                photo: uploadResponse.data.photo,
                hash: uploadResponse.data.hash,
                group_id: process.env.GROUP_ID
            });

            // В пустой массив кладем форма отпрвки PHOTO
            attachmentsPhotos.push(`photo${saveResponse[0].owner_id}_${saveResponse[0].id}`)
        };

        
        const attachmentsPhotosRaeady = attachmentsPhotos.join(',')

        console.log(colors.bgGray.brightGreen('Все фотографии были отправлены на сервер VK'));
        return attachmentsPhotosRaeady
    } catch (error) {
        console.log('Ошибка при загрузке фотографий на сервер VK: ', error)
    }
}
// Отправка данных на стену группы
async function funcSendPhotosInGroup(attachmentsPhotosRaeady, context) {
    try {
        await token_user.api.wall.post({
            owner_id: -process.env.GROUP_ID,
            from_group: 1,
            attachments: attachmentsPhotosRaeady,
        })
        console.log(colors.bgGray.brightGreen('Все фотографии были выставлены на стену в группе'));
        context.send(`Фотографии были выставлены в группу`)
    } catch (error) {
        console.log('Ошибка при отправке фотографий на стену: ', error)
    }
}

async function funcUploadServer() {
    const uploadServer = await token_user.api.photos.getWallUploadServer({
        group_id: process.env.GROUP_ID
    })
    return uploadServer
}

updates.start().catch(console.error);   


// * * * * * * * * * * * * * * * * * * * * * * 
// * ФУНКЦИИ ДЛЯ ГРУПП, КОТОРЫЕ УЖЕ ПАРСЯТСЯ *
// * * * * * * * * * * * * * * * * * * * * * * 

async function funcWorkInAlreadyParsingGroup() {
    console.log('')
    console.log(colors.bgGray.brightMagenta('Начало парсинга групп'))

    // Вывод всех групп для дальнейших с ними работ
    const getAllGroups = await funcGetAllGroups()
    if(!getAllGroups.length) {
        console.log(colors.bgGray.brightMagenta('В БД нет групп для парсинга'))
        return
    }

    // Иттерация групп
    const photos = await funcMapGroups(getAllGroups)
    if(!photos[0] || !photos) return

    // Скачивания фотографий
    const updatePhotos = await funcDownloadPhotosAlr(photos)
    // Отправка фото в VK
    const attachmentsPhotosRaeady = await funcItterGroupForVk (updatePhotos)
    // Отправка данных на стену группы 
    await funcSendPhotosInGroups(attachmentsPhotosRaeady)
    // Обновление записей фотографий в БД 
    await funcUpdatePhotosInBase(updatePhotos)  
}
// Вывод всех групп
async function funcGetAllGroups() {
    const groups = await prisma.group.findMany({
        include: {
            photo: {
                include: true
            }
        }
    })
    return groups
}
// Итерация групп
async function funcMapGroups (getAllGroups) {
    let newPosts = []  
    
  
    const resultGetAllGroups = getAllGroups.map(async item => {
        const photos = await funcConstructorPhotosAlrParsing(item.domain, item.group_id, item.post_id, item.id)
        if(photos) newPosts.push(photos.post_object)
    })
    
    await Promise.all(resultGetAllGroups)

    // Фильтрация на наличие значений в фотографий
    newPosts = newPosts.filter(item => item.photos.length > 0)
    return newPosts
}
// Итерация постов в группе, которую парсим на типизацию, чтобы были только PHOTO (могут попасться VIDEO)
async function funcConstructorPhotosAlrParsing(domain, group_id, post_id, group_bd_id) {
    let offset = 0;
    let result;

    
    do {
        result = await funcWallGetAlrParsing(domain, group_id, offset, post_id, group_bd_id) 
        if(result.still_iteration) {
            offset += 1
            console.log(colors.bgGray.brightMagenta(`Пост является закрепом или не имеет своих фотографий в группе ${colors.brightYellow(domain)} ...`))
        }
    } while (result.still_iteration);

    

    return result
}
// Парсинг PHOTO уже зарегестрированных групп у нас в БД
async function funcWallGetAlrParsing(domain, group_id, offset, post_id, group_bd_id) {
    console.log(colors.bgGray.brightMagenta(`Парсим группу ${colors.brightYellow(domain)} ...`))
    
    // Запрос на ФОТО у ОДНОГО поста у группы
    const post = await token_user.api.wall.get({
        owner_id: group_id,
        domain: domain,
        offset: offset,
        count: 1,
        filter: 'all'
    })
    
    let post_object = {
        id: group_bd_id,
        domain: domain,
        group_id: group_id,
        post_id: -1,
        photos: []
    }

    const items = post.items[0]
    const isPinned = items.is_pinned
    const attach = items.attachments


    if(isPinned === undefined && attach.length > 0) {
        if(items.id !== post_id){ 
            attach.map(item => {
                if(item.type === 'photo') post_object.photos.push({id: item.photo.id, url: item.photo.orig_photo.url})
            })
            post_object.post_id = items.id
            return {still_iteration: false, post_object: post_object}
        }
        else return {still_iteration: false, post_object: post_object}
    }else{
        return {still_iteration: true}
    }   
}
// Итерация объектов (групп с новыми фотографиями) для их скачивания
async function funcDownloadPhotosAlr(photos) {
    const downloadMapPhotos = photos.map(async item => {
        // Удаление старых фотографий
        await funcDeleteAllFilesInFolder(item.domain)
        // Скачать ФОТО
        const namePhoto = await funcDownloadPhotos(item)
        item.namesPhotos = namePhoto
    })

    await Promise.all(downloadMapPhotos)

    return photos
}
// Удаление старых фотографий
async function funcDeleteAllFilesInFolder(domain) {
    try {
        const pathFolder = path.resolve('photos', domain)
        const files = await fsPromise.readdir(pathFolder);


        for (const file of files) {
            const filePath = path.join(pathFolder, file);
            await fsPromise.unlink(filePath);
            console.log(colors.bgGray.brightMagenta(`Удалена фотография ${colors.brightYellow(file)} из папки ${colors.brightYellow(domain)}`))
        }
    } catch (error) {
        console.error('Ошибка при удалении файлов:', error);
    }
}
// Удаление старых PHOTO и добавление новых в БД
async function funcUpdatePhotosInBase(photos) {
    try {
        photos.map(async item => {
            const group = await prisma.group.findFirst({where: {domain: item.domain}})
            let createArray = []

            item.namesPhotos.map((name, index) => createArray.push({photo_id: item.photos[index].id, name: name, group_id: group.id}))
    
            await prisma.group.update({ where: {id: item.id }, data: {post_id: +item.post_id }})
            await prisma.photo.deleteMany({ where: {group_id: item.id}})
            await prisma.photo.createMany({ data: createArray })
            console.log(colors.bgGray.brightMagenta(`Фотографии группы ${item.domain} отправлены в группу`))
        })
    } catch (error) {
        console.log('Ошибка при отправлении фотографий в группу: ', error)
    }
}
// Отправка данных в БД VK
async function funcItterGroupForVk(updatePhotos) {
    let attachmentsPhotosRaeady = []
    const itterGGroup = updatePhotos.map(async item => {
        const result = await funcSendPhotosInBaseVk(item, item.namesPhotos)
        attachmentsPhotosRaeady.push([result])
    })

    await Promise.all(itterGGroup)

    return attachmentsPhotosRaeady
}
// Отправка данных на стену группы
async function funcSendPhotosInGroups(photos) {
    try {
        await Promise.all(photos.map(async item => {
            let attachmentsPhotosRaeady = item.join(',')
            await token_user.api.wall.post({
                owner_id: -process.env.GROUP_ID,
                from_group: 1,
                attachments: attachmentsPhotosRaeady,
            })
        }))

        console.log(colors.bgGray.brightGreen('Все фотографии были выставлены на стену в группе:D'));
    } catch (error) {
        console.log('Ошибка при отправке фотографий на стену: ', error)
    }
} 

setInterval(async () => await funcWorkInAlreadyParsingGroup(), 5000)