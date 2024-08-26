import { VK } from 'vk-io'
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

updates.on('message_new', async (context) => {
    // Проверка User
    await funcCheckPersonId(context)

    // Создание папки Photos
    await funcCheckingFolderPhotos()  

    // Берем Домен
    const domain = funcTakeDomain(context)

    // Проверка на уникальнсоть группы в БД
    const checkGroup = await funcFoundGroup(domain)
    if(checkGroup !== null) context.send(`${domain} уже парсится, выберите другую`)

    // Информация о группе
    const groupInfo = await funcGroupGetById(domain)

    // Спарсили PHOTO
    const photos = await funcConstructorPhotos(domain, groupInfo.id)

    // Скачать ФОТО
    const namePhoto = await funcDownloadPhotos(photos)  

    // Отпрвка данных в нашу БД
    await funcRegistredGroupInBase(photos, namePhoto)

    // Отправка фотографий на Сервер VK
    const attachmentsPhotosRaeady = await funcSendPhotosInBaseVk(photos, namePhoto)

    await funcSendPhotosInGroup(attachmentsPhotosRaeady)
});  

// Проверка User
async function funcCheckPersonId(context) {
    if(context.senderId !== +process.env.SENDER_ID) return context.send('Вы не являетесь владельцем или администратором данной группы :D') 
    else return 
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
    if(!domain) return context.send('Напишите корерктуню ссылку')

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
 
    // Фильтрация поста на ФОТО
    post.items[0].attachments.map(item => {
        if(item.type === 'photo')  {
            post_object.photos.push({id: item.photo.id, url: item.photo.orig_photo.url})
            isRes = true
        }
        else isRes = false
    })

    if(isRes) return post_object
    else false
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
async function funcSendPhotosInGroup(attachmentsPhotosRaeady) {
    try {
        await token_user.api.wall.post({
            owner_id: -process.env.GROUP_ID,
            from_group: 1,
            attachments: attachmentsPhotosRaeady,
        })
        console.log(colors.bgGray.brightGreen('Все фотографии были выставлены на стену в группе'));
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

updates.start()   


// * * * * * * * * * * * * * * * * * * * * * * 
// * ФУНКЦИИ ДЛЯ ГРУПП, КОТОРЫЕ УЖЕ ПАРСЯТСЯ *
// * * * * * * * * * * * * * * * * * * * * * * 

async function funcWorkInAlreadyParsingGroup() {
    console.log(colors.bgGray.brightMagenta('Начало парсинга групп'))

    // Вывод всех групп для дальнейших с ними работ
    const getAllGroups = await funcGetAllGroups()
    if(!getAllGroups.length) {
        console.log(colors.bgGray.brightMagenta('В БД нет групп для парсинга'))
        return
    }

    // Иттерация групп
    const photos = await funcMapGroups(getAllGroups)
    // Скачивания фотографий
    const downloadPhotos = await funcDownloadPhotosAlr(photos)

    console.log('')
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
        const photos = await funcConstructorPhotosAlrParsing(item.domain, item.group_id, item.post_id)
        if(photos.photos.length > 0) newPosts.push(photos)
    })
    
    await Promise.all(resultGetAllGroups)

    return newPosts
}
// Итерация постов в группе, которую парсим на типизацию, чтобы были только PHOTO (могут попасться VIDEO)
async function funcConstructorPhotosAlrParsing(domain, group_id, post_id) {
    let offset = 0;
    let result;

    do {
        result = await funcWallGetAlrParsing(domain, group_id, offset, post_id) 
        if(!result) offset = offset + 1 
    } while (!result);

    return result
}
// Парсинг PHOTO уже зарегестрированных групп у нас в БД
async function funcWallGetAlrParsing(domain, group_id, offset, post_id) {
    console.log(colors.bgGray.brightMagenta(`Парсим группу ${colors.brightYellow(domain)} ...`))
    let isRes = true
    
    // Запрос на ФОТО у ОДНОГО поста у группы
    const post = await token_user.api.wall.get({
        owner_id: group_id,
        domain: domain,
        offset: offset,
        count: 1,
        filter: 'all'
    })
    
    // Условие на то, если у группы закончились посты
    if(post.items.length > 0) {
        // Подготовили массив для заполнения
        let post_object = {
            domain: domain,
            group_id: group_id,
            post_id: 0,
            photos: []
        }
        // Условие на сходство постов, если одинаковые, то парсинга не будет
        if(post_id !== post.items[0].id){
            // Фильтрация поста на ФОТО
            post.items[0].attachments.map(item => {
                if(item.type === 'photo')  {
                    post_object.photos.push({id: item.photo.id, url: item.photo.orig_photo.url})
                    isRes = true
                } else isRes = false
            })
            console.log(colors.bgGray.brightMagenta(`В группе ${colors.brightYellow(domain)} ${colors.brightGreen('ЕСТЬ')} новый контент`))
        }else console.log(colors.bgGray.brightMagenta(`В группе ${colors.brightYellow(domain)} ${colors.brightRed('НЕТ')} нового контента`))
        if(isRes) return post_object
        else false
    }
}
// Иттерация объектов (групп с новыми фотографиями) для их скачивания
async function funcDownloadPhotosAlr(photos) {
    const downloadMapPhotos = photos.map(async item => {
        await funcDeleteAllFilesInFolder(item.domain)
        await funcDownloadPhotos(item)
    })

    await Promise.all(downloadMapPhotos)
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

setInterval(async () => await funcWorkInAlreadyParsingGroup(), 5000)